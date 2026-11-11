package dev.agner.template.integrationTest.config

import dev.agner.template.integrationTest.helpers.getBean
import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.request.get
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.http.ContentType
import io.ktor.http.contentType
import io.ktor.http.path
import org.springframework.core.env.Environment

class BaseHttpRequestTemplate {
    lateinit var path: String
    var body: Any = emptyMap<String, String>()
}

// The app port is the one the harness published for this run, read back from the Spring
// environment, so the request follows the server instead of assuming a host port.
suspend fun resolveAppBaseUrl() =
    "http://localhost:${getBean<Environment>().getRequiredProperty("ktor.port")}"

suspend inline fun <reified T> getRequest(crossinline configure: BaseHttpRequestTemplate.() -> Unit) =
    getBean<HttpClient>().get(resolveAppBaseUrl()) {
        url {
            path(BaseHttpRequestTemplate().apply(configure).path)
        }
    }.body<T>()

suspend inline fun <reified T> postRequest(crossinline configure: BaseHttpRequestTemplate.() -> Unit) =
    getBean<HttpClient>().post(resolveAppBaseUrl()) {
        url {
            path(BaseHttpRequestTemplate().apply(configure).path)
        }
        contentType(ContentType.Application.Json)
        setBody(BaseHttpRequestTemplate().apply(configure).body)
    }.body<T>()
