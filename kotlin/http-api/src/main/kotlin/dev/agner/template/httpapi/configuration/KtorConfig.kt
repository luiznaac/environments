package dev.agner.template.httpapi.configuration

import com.fasterxml.jackson.databind.ObjectMapper
import dev.agner.template.httpapi.controller.ControllerTemplate
import dev.agner.template.usecase.commons.logger
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpMethod
import io.ktor.serialization.jackson.JacksonConverter
import io.ktor.server.application.install
import io.ktor.server.engine.EmbeddedServer
import io.ktor.server.engine.embeddedServer
import io.ktor.server.netty.Netty
import io.ktor.server.plugins.contentnegotiation.ContentNegotiation
import io.ktor.server.plugins.cors.routing.CORS
import io.ktor.server.routing.routing
import org.springframework.beans.factory.annotation.Value
import org.springframework.context.annotation.Configuration

@Configuration
class KtorConfig(
    private val routes: Set<ControllerTemplate>,
    private val mapper: ObjectMapper,
    @Value("\${ktor.wait}") wait: Boolean,
    @Value("\${ktor.port}") port: Int,
) {

    private val server: EmbeddedServer<*, *>

    init {
        val log = logger()

        server = embeddedServer(Netty, port = port) {
            routes.onEach {
                log.info("Initializing route: ${it::class.java.simpleName}")
                routing(it.routes())
            }

            install(ContentNegotiation) {
                register(ContentType.Application.Json, JacksonConverter(mapper))
            }

            install(CORS) {
                allowMethod(HttpMethod.Options)
                allowMethod(HttpMethod.Put)
                allowMethod(HttpMethod.Delete)
                allowMethod(HttpMethod.Patch)
                allowHeader(HttpHeaders.Authorization)
                allowHeader(HttpHeaders.ContentType)
                anyHost()
            }
        }.start(wait = wait)
    }

    fun stop() = server.stop(0, 0)
}
