package com.omnimem.companion

import android.view.accessibility.AccessibilityNodeInfo

/**
 * Lettura del contenuto a schermo tramite l'albero di accessibilità — non c'è
 * equivalente del DOM/CSS selector usato dall'estensione Chrome, quindi qui si
 * raccoglie tutto il testo visibile della finestra attiva (approccio più
 * grezzo del "target estrazione" manuale dell'estensione).
 */
object NodeExtractor {

    private const val MAX_NODES = 4000

    fun extractScreenText(root: AccessibilityNodeInfo?): String {
        if (root == null) return ""
        val pieces = mutableListOf<String>()
        val seen = mutableSetOf<String>()
        walk(root, pieces, seen, intArrayOf(0))
        return pieces.joinToString("\n")
    }

    private fun walk(
        node: AccessibilityNodeInfo,
        out: MutableList<String>,
        seen: MutableSet<String>,
        budget: IntArray,
    ) {
        if (budget[0] >= MAX_NODES) return
        budget[0]++

        val text = node.text?.toString()?.trim()
        if (!text.isNullOrEmpty() && seen.add(text)) {
            out.add(text)
        }

        for (i in 0 until node.childCount) {
            val child = node.getChild(i) ?: continue
            walk(child, out, seen, budget)
        }
    }

    fun findFocusedEditable(root: AccessibilityNodeInfo?): AccessibilityNodeInfo? {
        val focused = root?.findFocus(AccessibilityNodeInfo.FOCUS_INPUT)
        return focused?.takeIf { it.isEditable }
    }
}
