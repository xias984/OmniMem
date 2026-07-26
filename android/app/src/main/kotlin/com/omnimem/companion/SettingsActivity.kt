package com.omnimem.companion

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.provider.Settings
import android.widget.ArrayAdapter
import android.widget.AutoCompleteTextView
import android.widget.Button
import android.widget.EditText
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

class SettingsActivity : AppCompatActivity() {

    private lateinit var prefs: OmniMemPrefs
    private lateinit var api: OmniMemApiClient

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_settings)
        prefs = OmniMemPrefs(this)
        api = OmniMemApiClient(prefs)

        val serverUrlField = findViewById<EditText>(R.id.field_server_url)
        val tokenField = findViewById<EditText>(R.id.field_api_token)
        val topicField = findViewById<AutoCompleteTextView>(R.id.field_topic)

        serverUrlField.setText(prefs.serverUrl)
        tokenField.setText(prefs.apiToken)
        topicField.setText(prefs.defaultTopic)

        findViewById<Button>(R.id.btn_save).setOnClickListener {
            if (!saveServerUrl(serverUrlField.text.toString())) return@setOnClickListener
            prefs.apiToken = tokenField.text.toString()
            prefs.defaultTopic = topicField.text.toString().ifBlank { "Generale" }
            Toast.makeText(this, "Impostazioni salvate.", Toast.LENGTH_SHORT).show()
        }

        findViewById<Button>(R.id.btn_refresh_topics).setOnClickListener {
            // Salva URL/token correnti prima di interrogare il server, così
            // funziona anche se non hai ancora premuto "Salva".
            if (!saveServerUrl(serverUrlField.text.toString())) return@setOnClickListener
            prefs.apiToken = tokenField.text.toString()
            api.listTopics { topics, error ->
                runOnUiThread {
                    if (topics == null) {
                        Toast.makeText(this, "Errore: $error", Toast.LENGTH_SHORT).show()
                        return@runOnUiThread
                    }
                    topicField.setAdapter(
                        ArrayAdapter(this, android.R.layout.simple_dropdown_item_1line, topics),
                    )
                    Toast.makeText(this, "${topics.size} topic trovati.", Toast.LENGTH_SHORT).show()
                }
            }
        }

        findViewById<Button>(R.id.btn_open_accessibility_settings).setOnClickListener {
            startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
        }

        findViewById<Button>(R.id.btn_open_overlay_settings).setOnClickListener {
            startActivity(
                Intent(
                    Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                    Uri.parse("package:$packageName"),
                ),
            )
        }
    }

    // Request.Builder().url() nel client HTTP lancia se l'URL è malformato:
    // meglio rifiutarlo qui, con un messaggio chiaro, che farlo scoprire
    // all'utente come crash al primo Rec/Inject.
    private fun saveServerUrl(raw: String): Boolean {
        val trimmed = raw.trim().trimEnd('/')
        val parsed = trimmed.toHttpUrlOrNull()
        if (parsed == null || (parsed.scheme != "http" && parsed.scheme != "https")) {
            Toast.makeText(this, "URL server non valido (usa http:// o https://).", Toast.LENGTH_LONG).show()
            return false
        }
        prefs.serverUrl = trimmed
        return true
    }
}
