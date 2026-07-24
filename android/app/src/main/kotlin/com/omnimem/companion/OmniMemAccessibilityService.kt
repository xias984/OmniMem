package com.omnimem.companion

import android.accessibilityservice.AccessibilityService
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo

class OmniMemAccessibilityService : AccessibilityService() {

    private var overlay: OverlayController? = null

    override fun onServiceConnected() {
        super.onServiceConnected()
        instance = this
        overlay = OverlayController(this).also { it.show() }
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        // Stato letto on-demand da rootInActiveWindow al tap dei bottoni,
        // non serve tracciare nulla qui.
    }

    override fun onInterrupt() {}

    override fun onDestroy() {
        overlay?.hide()
        overlay = null
        instance = null
        super.onDestroy()
    }

    fun currentEditableNode(): AccessibilityNodeInfo? =
        NodeExtractor.findFocusedEditable(rootInActiveWindow)

    fun currentMessages(): List<Pair<String, String>> = NodeExtractor.extractMessages(rootInActiveWindow)

    fun currentScreenText(): String = NodeExtractor.extractScreenText(rootInActiveWindow)

    fun currentSourceApp(): String = rootInActiveWindow?.packageName?.toString() ?: "unknown"

    companion object {
        var instance: OmniMemAccessibilityService? = null
            private set
    }
}
