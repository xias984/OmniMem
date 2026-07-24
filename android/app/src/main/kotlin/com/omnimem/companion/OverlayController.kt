package com.omnimem.companion

import android.content.Context
import android.graphics.PixelFormat
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.LayoutInflater
import android.view.MotionEvent
import android.view.View
import android.view.WindowManager
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
        val text = service.currentScreenText()
        val sourceApp = service.currentSourceApp()
        if (text.isBlank()) {
            toast("Niente testo leggibile a schermo.")
            return
        }
        api.record(listOf("screen" to text), prefs.defaultTopic, sourceApp) { ok, error ->
            mainHandler.post { toast(if (ok) "Salvato nella memoria." else "Errore: $error") }
        }
    }

    private fun onInjectClicked() {
        val node = service.currentEditableNode()
        if (node == null) {
            toast("Nessun campo di testo attivo trovato.")
            return
        }
        val draft = node.text?.toString().orEmpty()
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
                val block = "--- CONTESTO DALLA TUA MEMORIA PERSONALE ---\n" +
                    chunks.joinToString("\n---\n") +
                    "\n--- FINE CONTESTO ---"
                val ok = NodeInjector.prependContext(node, block)
                toast(if (ok) "Contesto inserito." else "Impossibile scrivere nel campo.")
            }
        }
    }

    private fun toast(msg: String) = Toast.makeText(service, msg, Toast.LENGTH_SHORT).show()
}
