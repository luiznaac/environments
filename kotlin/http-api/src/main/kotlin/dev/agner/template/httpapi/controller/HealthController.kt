package dev.agner.template.httpapi.controller

import dev.agner.template.usecase.commons.mapAsync
import dev.agner.template.usecase.health.HealthChecker
import io.ktor.http.HttpStatusCode
import io.ktor.server.response.respond
import io.ktor.server.routing.get
import io.ktor.server.routing.route
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.withContext
import org.springframework.stereotype.Component

@Component
class HealthController(
    private val healthHandler: HealthHandler,
) : ControllerTemplate {

    override fun routes(): RouteDefinition = {
        route("/health") {
            get {
                call.respond(HttpStatusCode.OK, healthHandler.healthCheck())
            }

            get("/internal") {
                call.respond(HttpStatusCode.OK, mapOf("is_healthy" to true))
            }
        }
    }
}

@Component
class HealthHandler(
    private val healthCheckers: Set<HealthChecker>,
) {

    suspend fun healthCheck() = withContext(Dispatchers.IO) {
        healthCheckers.mapAsync { it.getHealthStatus() }.awaitAll()
    }
}
