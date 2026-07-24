package com.omnimem.companion

import android.content.Context

class OmniMemPrefs(context: Context) {
    private val prefs = context.getSharedPreferences("omnimem_prefs", Context.MODE_PRIVATE)

    var serverUrl: String
        get() = prefs.getString(KEY_SERVER_URL, "").orEmpty()
        set(value) = prefs.edit().putString(KEY_SERVER_URL, value.trimEnd('/')).apply()

    var apiToken: String
        get() = prefs.getString(KEY_API_TOKEN, "").orEmpty()
        set(value) = prefs.edit().putString(KEY_API_TOKEN, value).apply()

    var defaultTopic: String
        get() = prefs.getString(KEY_TOPIC, "Generale").orEmpty()
        set(value) = prefs.edit().putString(KEY_TOPIC, value).apply()

    companion object {
        private const val KEY_SERVER_URL = "server_url"
        private const val KEY_API_TOKEN = "api_token"
        private const val KEY_TOPIC = "default_topic"
    }
}
