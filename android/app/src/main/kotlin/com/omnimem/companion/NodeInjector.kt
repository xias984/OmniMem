package com.omnimem.companion

import android.os.Bundle
import android.view.accessibility.AccessibilityNodeInfo

/**
 * Equivalente mobile di setPrompt() in extension/content_script.js: prepende
 * il blocco di contesto al testo già presente nel campo, invece di
 * sovrascriverlo.
 */
object NodeInjector {

    fun prependContext(node: AccessibilityNodeInfo, contextBlock: String): Boolean {
        val current = node.text?.toString().orEmpty()
        val combined = if (current.isBlank()) contextBlock else "$contextBlock\n\n$current"
        val bundle = Bundle().apply {
            putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, combined)
        }
        return node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, bundle)
    }
}
