package com.omnimem.companion

import okhttp3.Call
import okhttp3.Callback
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.TimeUnit

/**
 * Client sottile verso il bridge server esistente (server/server.js) — riusa
 * /api/query e /api/record senza modifiche lato server oltre al token di auth.
 */
class OmniMemApiClient(private val prefs: OmniMemPrefs) {

    private val client = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .build()

    private val jsonMedia = "application/json; charset=utf-8".toMediaType()

    private fun request(path: String, body: JSONObject?): Request {
        val builder = Request.Builder().url(prefs.serverUrl + path)
        if (prefs.apiToken.isNotBlank()) {
            builder.addHeader("X-OmniMem-Token", prefs.apiToken)
        }
        if (body != null) {
            builder.post(body.toString().toRequestBody(jsonMedia))
        }
        return builder.build()
    }

    fun listTopics(onResult: (List<String>?, String?) -> Unit) {
        if (prefs.serverUrl.isBlank()) {
            onResult(null, "Server URL non configurato")
            return
        }
        client.newCall(request("/api/topics", null)).enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                onResult(null, e.message ?: "Errore di rete")
            }

            override fun onResponse(call: Call, response: Response) {
                response.use {
                    if (!it.isSuccessful) {
                        onResult(null, "Server ${it.code}")
                        return
                    }
                    val json = JSONObject(it.body?.string().orEmpty())
                    val topicsJson = json.optJSONArray("topics") ?: JSONArray()
                    val topics = (0 until topicsJson.length()).map { i -> topicsJson.getString(i) }
                    onResult(topics, null)
                }
            }
        })
    }

    fun query(text: String, topic: String, k: Int = 4, onResult: (List<String>?, String?) -> Unit) {
        if (prefs.serverUrl.isBlank()) {
            onResult(null, "Server URL non configurato")
            return
        }
        val body = JSONObject().apply {
            put("query", text)
            put("topic", topic)
            put("k", k)
        }
        client.newCall(request("/api/query", body)).enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                onResult(null, e.message ?: "Errore di rete")
            }

            override fun onResponse(call: Call, response: Response) {
                response.use {
                    if (!it.isSuccessful) {
                        onResult(null, "Server ${it.code}")
                        return
                    }
                    val json = JSONObject(it.body?.string().orEmpty())
                    val chunksJson = json.optJSONArray("chunks") ?: JSONArray()
                    val chunks = (0 until chunksJson.length()).map { i -> chunksJson.getString(i) }
                    onResult(chunks, null)
                }
            }
        })
    }

    fun record(
        messages: List<Pair<String, String>>,
        topic: String,
        sourceApp: String,
        onResult: (Boolean, String?) -> Unit,
    ) {
        if (prefs.serverUrl.isBlank()) {
            onResult(false, "Server URL non configurato")
            return
        }
        val messagesJson = JSONArray()
        messages.forEach { (role, text) ->
            messagesJson.put(
                JSONObject().apply {
                    put("role", role)
                    put("text", text)
                },
            )
        }
        val body = JSONObject().apply {
            put("messages", messagesJson)
            put("topic", topic)
            put(
                "metadata",
                JSONObject().apply {
                    put("platform", sourceApp)
                    put("source_url", "android://$sourceApp")
                    put("timestamp", System.currentTimeMillis())
                },
            )
        }
        client.newCall(request("/api/record", body)).enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                onResult(false, e.message ?: "Errore di rete")
            }

            override fun onResponse(call: Call, response: Response) {
                response.use {
                    onResult(it.isSuccessful, if (it.isSuccessful) null else "Server ${it.code}")
                }
            }
        })
    }
}
