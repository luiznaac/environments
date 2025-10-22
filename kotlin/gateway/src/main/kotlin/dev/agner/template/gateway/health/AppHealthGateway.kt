package dev.agner.template.gateway.health

import dev.agner.template.usecase.health.HealthGateway
import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.request.get
import org.springframework.beans.factory.annotation.Value
import org.springframework.stereotype.Component

@Component
class AppHealthGateway(
    private val client: HttpClient,
    @param:Value("\${ktor.port}") private val port: Int,
) : HealthGateway {

    override suspend fun isHealthy() = client
        .get("http://localhost:$port/health/internal")
        .body<HealthData>()
        .isHealthy
}

private data class HealthData(val isHealthy: Boolean)
