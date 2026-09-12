package dev.agner.template.httpapi.configuration

import dev.agner.template.usecase.commons.DomainException
import io.ktor.server.application.Application
import io.ktor.server.application.install
import io.ktor.server.plugins.statuspages.StatusPages
import io.ktor.server.plugins.statuspages.exception
import io.ktor.server.response.respond

fun Application.installDomainExceptionHandler(mapper: DomainExceptionStatusMapper) {
    install(StatusPages) {
        exception<DomainException> { call, cause ->
            call.respond(
                mapper.statusFor(cause),
                ApiError(error = cause.error, message = cause.userMessage, detail = cause.detail),
            )
        }
    }
}

private data class ApiError(
    val error: String,
    val message: String,
    val detail: String,
)
