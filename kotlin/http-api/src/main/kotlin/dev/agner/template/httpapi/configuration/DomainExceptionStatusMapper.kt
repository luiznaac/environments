package dev.agner.template.httpapi.configuration

import dev.agner.template.usecase.commons.DomainException
import io.ktor.http.HttpStatusCode
import org.springframework.stereotype.Component

interface DomainExceptionStatusMapper {
    fun statusFor(exception: DomainException): HttpStatusCode
}

@Component
class DefaultDomainExceptionStatusMapper : DomainExceptionStatusMapper {
    override fun statusFor(exception: DomainException): HttpStatusCode = when (exception) {
        // Add a branch per domain exception that needs a non-400 status, e.g.
        // is NotFoundException -> HttpStatusCode.NotFound
        // is ConflictException -> HttpStatusCode.Conflict
        else -> HttpStatusCode.BadRequest
    }
}
