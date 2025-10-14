package dev.agner.template.gateway.configuration

import com.fasterxml.jackson.databind.ObjectMapper
import io.ktor.client.HttpClient
import io.ktor.client.plugins.contentnegotiation.ContentNegotiation
import io.ktor.http.ContentType
import io.ktor.serialization.jackson.JacksonConverter
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration

@Configuration
class KtorClientConfig(
    private val mapper: ObjectMapper,
) {

    @Bean
    fun ktorClient() = HttpClient {
        install(ContentNegotiation) {
            register(ContentType.Application.Json, JacksonConverter(mapper))
        }
    }
}
