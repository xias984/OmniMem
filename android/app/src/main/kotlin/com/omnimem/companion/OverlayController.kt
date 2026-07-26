package com.omnimem.companion

import android.content.Context
import android.graphics.PixelFormat
import android.graphics.Rect
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.view.Gravity
import android.view.LayoutInflater
import android.view.MotionEvent
import android.view.View
import android.view.WindowManager
import android.view.accessibility.AccessibilityNodeInfo
import android.widget.Toast
import kotlin.math.abs

/**
 * Bottone flottante + pannello Rec/Inject — l'equivalente mobile del
 * pannello che extension/content_script.js inietta in ogni pagina.
 */
class OverlayController(private val service: OmniMemAccessibilityService) {

    private val windowManager = service.getSystemService(Context.WINDOW_SERVICE) as WindowManager
    private val prefs = OmniMemPrefs(service)
    private val api = OmniMemApiClient(prefs)
    private val mainHandler = Handler(Looper.getMainLooper())

    private var bubbleView: View? = null
    private var panelView: View? = null

    fun show() {
        if (bubbleView != null) return
        if (!Settings.canDrawOverlays(service)) {
            // Se l'accessibility service viene abilitato prima del permesso
            // overlay, evitiamo di far crashare WindowManager: il bottone
            // comparirà al riavvio del servizio (basta ri-attivarlo dalle
            // impostazioni di accessibilità) una volta concesso il permesso.
            Toast.makeText(
                service,
                "Concedi il permesso \"disegna sopra altre app\" a OmniMem Companion, poi riattiva il servizio di accessibilità.",
                Toast.LENGTH_LONG,
            ).show()
            return
        }
        val bubble = LayoutInflater.from(service).inflate(R.layout.overlay_bubble, null)

        val params = WindowManager.LayoutParams(
            WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE,
            PixelFormat.TRANSLUCENT,
        ).apply {
            gravity = Gravity.TOP or Gravity.START
            x = 0
            y = 300
        }

        makeDraggable(bubble, params)
        bubble.setOnClickListener { toggleActionPanel() }

        windowManager.addView(bubble, params)
        bubbleView = bubble
    }

    fun hide() {
        panelView?.let { runCatching { windowManager.removeView(it) } }
        bubbleView?.let { runCatching { windowManager.removeView(it) } }
        panelView = null
        bubbleView = null
    }

    private fun makeDraggable(view: View, params: WindowManager.LayoutParams) {
        var startX = 0
        var startY = 0
        var touchX = 0f
        var touchY = 0f
        var moved = false

        view.setOnTouchListener { v, event ->
            when (event.action) {
                MotionEvent.ACTION_DOWN -> {
                    startX = params.x
                    startY = params.y
                    touchX = event.rawX
                    touchY = event.rawY
                    moved = false
                    true
                }
                MotionEvent.ACTION_MOVE -> {
                    val dx = (event.rawX - touchX).toInt()
                    val dy = (event.rawY - touchY).toInt()
                    if (abs(dx) > 8 || abs(dy) > 8) moved = true
                    params.x = startX + dx
                    params.y = startY + dy
                    windowManager.updateViewLayout(view, params)
                    true
                }
                MotionEvent.ACTION_UP -> {
                    if (!moved) v.performClick()
                    true
                }
                else -> false
            }
        }
    }

    private fun toggleActionPanel() {
        val existing = panelView
        if (existing != null) {
            windowManager.removeView(existing)
            panelView = null
            return
        }

        val panel = LayoutInflater.from(service).inflate(R.layout.overlay_panel, null)
        panel.findViewById<View>(R.id.btn_rec).setOnClickListener { onRecClicked() }
        panel.findViewById<View>(R.id.btn_inject).setOnClickListener { onInjectClicked() }

        val params = WindowManager.LayoutParams(
            WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE,
            PixelFormat.TRANSLUCENT,
        ).apply {
            gravity = Gravity.TOP or Gravity.START
            x = 0
            y = 380
        }

        windowManager.addView(panel, params)
        panelView = panel
    }

    private fun onRecClicked() {
        val sourceApp = service.currentSourceApp()
        val messages = service.currentMessages().ifEmpty {
            service.currentScreenText().takeIf { it.isNotBlank() }?.let { listOf("screen" to it) }.orEmpty()
        }
        if (messages.isEmpty()) {
            toast("Niente testo leggibile a schermo.")
            return
        }
        // Un capture_id univoco per pressione: senza, Rec ripetuti sulla
        // stessa app riusano gli stessi ID lato server e ogni nuova
        // registrazione sovrascrive silenziosamente quella precedente.
        val captureId = "${System.currentTimeMillis()}_${(1000..9999).random()}"
        api.record(messages, prefs.defaultTopic, sourceApp, captureId) { ok, error ->
            mainHandler.post {
                toast(if (ok) "Salvati ${messages.size} messaggi." else "Errore: $error")
            }
        }
    }

    private fun onInjectClicked() {
        val node = service.currentEditableNode()
        if (node == null) {
            toast("Nessun campo di testo attivo trovato.")
            return
        }
        val draft = node.text?.toString().orEmpty()
        val targetSignature = TargetSignature.of(node)
        api.query(draft, prefs.defaultTopic) { chunks, error ->
            mainHandler.post {
                if (chunks == null) {
                    toast("Errore: $error")
                    return@post
                }
                if (chunks.isEmpty()) {
                    toast("Nessun contesto rilevante trovato.")
                    return@post
                }

                // Tra l'avvio della query e questa callback l'utente può aver
                // cambiato campo — anche restando nella stessa app (nuova
                // conversazione, ricerca, ecc.) — o il testo può essere
                // cambiato sotto lo stesso campo. In entrambi i casi il
                // contesto recuperato non è più affidabile: meglio annullare
                // che scrivere alla cieca su un target diverso da quello
                // interrogato.
                val freshNode = service.currentEditableNode()
                if (freshNode == null || TargetSignature.of(freshNode) != targetSignature) {
                    toast("Campo cambiato nel frattempo, iniezione annullata.")
                    return@post
                }
                if (freshNode.text?.toString().orEmpty() != draft) {
                    toast("Testo cambiato nel frattempo: riprova Inject per un contesto aggiornato.")
                    return@post
                }

                val block = "--- CONTESTO DALLA TUA MEMORIA PERSONALE ---\n" +
                    chunks.joinToString("\n---\n") +
                    "\n--- FINE CONTESTO ---"
                val ok = NodeInjector.prependContext(service, freshNode, block)
                toast(if (ok) "Contesto inserito." else "Impossibile scrivere nel campo.")
            }
        }
    }

    private fun toast(msg: String) = Toast.makeText(service, msg, Toast.LENGTH_SHORT).show()

    // Identifica il campo di destinazione al di là del solo package dell'app:
    // stessa finestra, stesso resource id (quando presente — le WebView non
    // ne hanno, da qui il fallback su classe + posizione a schermo) e stessi
    // bounds. Basta che uno di questi cambi per considerare il target diverso
    // da quello su cui era partita la query.
    private data class TargetSignature(
        val windowId: Int,
        val viewId: String?,
        val className: CharSequence?,
        val bounds: Rect,
    ) {
        companion object {
            fun of(node: AccessibilityNodeInfo): TargetSignature {
                val rect = Rect()
                node.getBoundsInScreen(rect)
                return TargetSignature(node.windowId, node.viewIdResourceName, node.className, rect)
            }
        }
    }
}
