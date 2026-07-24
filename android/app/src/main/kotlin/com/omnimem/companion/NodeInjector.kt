package com.omnimem.companion

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.accessibility.AccessibilityNodeInfo

/**
 * Equivalente mobile di setPrompt() in extension/content_script.js: prepende
 * il blocco di contesto al testo già presente nel campo, invece di
 * sovrascriverlo. Alcuni widget (campi custom, WebView ibride) rifiutano
 * ACTION_SET_TEXT: in quel caso si passa a un fallback via appunti +
 * ACTION_PASTE, che inserisce solo il blocco di contesto alla posizione 0
 * senza duplicare il draft già scritto.
 */
object NodeInjector {

    private const val CLIPBOARD_RESTORE_DELAY_MS = 3000L

    fun prependContext(context: Context, node: AccessibilityNodeInfo, contextBlock: String): Boolean {
        val current = node.text?.toString().orEmpty()
        val combined = if (current.isBlank()) contextBlock else "$contextBlock\n\n$current"

        if (setTextDirect(node, combined)) return true

        val prefix = if (current.isBlank()) contextBlock else "$contextBlock\n\n"
        return pasteAtStart(context, node, prefix)
    }

    private fun setTextDirect(node: AccessibilityNodeInfo, text: String): Boolean {
        val bundle = Bundle().apply {
            putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text)
        }
        return node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, bundle)
    }

    private fun pasteAtStart(context: Context, node: AccessibilityNodeInfo, text: String): Boolean {
        val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        val previousClip = clipboard.primaryClip

        clipboard.setPrimaryClip(ClipData.newPlainText("omnimem_context", text))

        node.performAction(AccessibilityNodeInfo.ACTION_FOCUS)
        val selectionBundle = Bundle().apply {
            putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_START_INT, 0)
            putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_END_INT, 0)
        }
        node.performAction(AccessibilityNodeInfo.ACTION_SET_SELECTION, selectionBundle)

        val pasted = node.performAction(AccessibilityNodeInfo.ACTION_PASTE)

        // Ripristina gli appunti originali dopo un attimo, per non lasciare
        // il contesto (potenzialmente sensibile) in giro nella clipboard.
        Handler(Looper.getMainLooper()).postDelayed({
            runCatching {
                clipboard.setPrimaryClip(previousClip ?: ClipData.newPlainText("", ""))
            }
        }, CLIPBOARD_RESTORE_DELAY_MS)

        return pasted
    }
}
