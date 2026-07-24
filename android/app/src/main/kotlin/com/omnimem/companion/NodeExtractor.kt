package com.omnimem.companion

import android.graphics.Rect
import android.view.accessibility.AccessibilityNodeInfo

/**
 * Lettura del contenuto a schermo tramite l'albero di accessibilità — non c'è
 * equivalente del DOM/CSS selector usato dall'estensione Chrome. Due
 * strategie:
 *  - extractMessages(): euristica "target estrazione" — cerca un contenitore
 *    con più figli dello stesso tipo con testo significativo (i "bubble" di
 *    una chat) e li tratta come messaggi separati, indovinando il ruolo
 *    dall'allineamento orizzontale (sinistra/destra) rispetto al contenitore.
 *  - extractScreenText(): fallback grezzo, tutto il testo visibile come
 *    blocco unico, usato quando l'euristica sopra non trova nulla.
 */
object NodeExtractor {

    private const val MAX_NODES = 4000
    private const val MIN_TEXT_LEN = 4
    private const val MIN_SIBLINGS = 3

    private class Candidate(val container: AccessibilityNodeInfo, val children: List<AccessibilityNodeInfo>)

    fun extractMessages(root: AccessibilityNodeInfo?): List<Pair<String, String>> {
        if (root == null) return emptyList()
        val candidate = findMessageContainer(root, intArrayOf(0)) ?: return emptyList()

        val containerRect = Rect()
        candidate.container.getBoundsInScreen(containerRect)
        val midX = (containerRect.left + containerRect.right) / 2

        return candidate.children.mapNotNull { child ->
            val text = collectText(child)
            if (text.isBlank()) return@mapNotNull null

            val childRect = Rect()
            child.getBoundsInScreen(childRect)
            val childMidX = (childRect.left + childRect.right) / 2
            val role = if (childMidX > midX) "user" else "assistant"
            role to text
        }
    }

    fun extractScreenText(root: AccessibilityNodeInfo?): String {
        if (root == null) return ""
        val pieces = mutableListOf<String>()
        val seen = mutableSetOf<String>()
        walk(root, pieces, seen, intArrayOf(0))
        return pieces.joinToString("\n")
    }

    fun findFocusedEditable(root: AccessibilityNodeInfo?): AccessibilityNodeInfo? {
        val focused = root?.findFocus(AccessibilityNodeInfo.FOCUS_INPUT)
        return focused?.takeIf { it.isEditable }
    }

    // ─── Euristica messaggi ───────────────────────────────────────────────

    private fun findMessageContainer(node: AccessibilityNodeInfo, budget: IntArray): Candidate? {
        if (budget[0] >= MAX_NODES) return null
        budget[0]++

        val children = (0 until node.childCount).mapNotNull { node.getChild(it) }
        var best: Candidate? = null

        val meaningful = children.filter { hasMeaningfulText(it) }
        if (meaningful.size >= MIN_SIBLINGS) {
            val classCounts = meaningful.groupingBy { it.className?.toString() ?: "" }.eachCount()
            val dominantClass = classCounts.maxByOrNull { it.value }?.key
            val matching = if (dominantClass.isNullOrEmpty()) meaningful
            else meaningful.filter { it.className?.toString() == dominantClass }
            if (matching.size >= MIN_SIBLINGS) {
                best = Candidate(node, matching)
            }
        }

        for (child in children) {
            val fromChild = findMessageContainer(child, budget)
            if (fromChild != null && (best == null || fromChild.children.size > best!!.children.size)) {
                best = fromChild
            }
        }

        return best
    }

    private fun hasMeaningfulText(node: AccessibilityNodeInfo): Boolean {
        val own = node.text?.toString()?.trim()
        if (!own.isNullOrEmpty() && own.length >= MIN_TEXT_LEN) return true
        for (i in 0 until node.childCount) {
            val childText = node.getChild(i)?.text?.toString()?.trim()
            if (!childText.isNullOrEmpty() && childText.length >= MIN_TEXT_LEN) return true
        }
        return false
    }

    private fun collectText(node: AccessibilityNodeInfo): String {
        val pieces = mutableListOf<String>()
        collectTextInto(node, pieces, intArrayOf(0))
        return pieces.joinToString(" ")
    }

    private fun collectTextInto(node: AccessibilityNodeInfo, out: MutableList<String>, budget: IntArray) {
        if (budget[0] >= MAX_NODES) return
        budget[0]++
        val text = node.text?.toString()?.trim()
        if (!text.isNullOrEmpty()) out.add(text)
        for (i in 0 until node.childCount) {
            node.getChild(i)?.let { collectTextInto(it, out, budget) }
        }
    }

    // ─── Fallback testo grezzo ────────────────────────────────────────────

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
}
