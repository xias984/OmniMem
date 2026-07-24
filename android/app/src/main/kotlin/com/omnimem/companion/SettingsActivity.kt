package com.omnimem.companion

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.provider.Settings
import android.widget.Button
import android.widget.EditText
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity

class SettingsActivity : AppCompatActivity() {

    private lateinit var prefs: OmniMemPrefs

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_settings)
        prefs = OmniMemPrefs(this)

        val serverUrlField = findViewById<EditText>(R.id.field_server_url)
        val tokenField = findViewById<EditText>(R.id.field_api_token)
        val topicField = findViewById<EditText>(R.id.field_topic)

        serverUrlField.setText(prefs.serverUrl)
        tokenField.setText(prefs.apiToken)
        topicField.setText(prefs.defaultTopic)

        findViewById<Button>(R.id.btn_save).setOnClickListener {
            prefs.serverUrl = serverUrlField.text.toString()
            prefs.apiToken = tokenField.text.toString()
            prefs.defaultTopic = topicField.text.toString().ifBlank { "Generale" }
            Toast.makeText(this, "Impostazioni salvate.", Toast.LENGTH_SHORT).show()
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
}
