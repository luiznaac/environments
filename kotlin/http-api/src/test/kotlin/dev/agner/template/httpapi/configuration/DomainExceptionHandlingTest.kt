package dev.agner.template.httpapi.configuration

import com.fasterxml.jackson.databind.ObjectMapper
import dev.agner.template.usecase.commons.DomainException
import io.kotest.core.spec.style.DescribeSpec
import io.kotest.matchers.shouldBe
import io.ktor.client.request.get
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.HttpStatusCode
import io.ktor.serialization.jackson.JacksonConverter
import io.ktor.server.application.Application
import io.ktor.server.application.install
import io.ktor.server.plugins.contentnegotiation.ContentNegotiation
import io.ktor.server.routing.get
import io.ktor.server.routing.routing
import io.ktor.server.testing.testApplication

private class TestDomainException(
    error: String = "test-error",
    userMessage: String = "something went wrong",
    detail: String = "the detail",
) : DomainException(error = error, userMessage = userMessage, detail = detail)

private class UnmappedTestDomainException : DomainException(
    error = "unmapped-error",
    userMessage = "unmapped",
    detail = "unmapped detail",
)

class DomainExceptionHandlingTest : DescribeSpec({

    describe("the DomainException status page") {

        it("serialises error, message and detail under the documented names") {
            testApplication {
                application { installThrowingRoute(TestDomainException()) }

                val response = client.get("/boom")
                val payload = ObjectMapper().readTree(response.bodyAsText())

                response.status shouldBe HttpStatusCode.BadRequest
                payload.get("error").asText() shouldBe "test-error"
                payload.get("message").asText() shouldBe "something went wrong"
                payload.get("detail").asText() shouldBe "the detail"
            }
        }

        it("takes the status from the mapper, not a hardcoded one") {
            val mapper = object : DomainExceptionStatusMapper {
                override fun statusFor(exception: DomainException) = HttpStatusCode.Conflict
            }

            testApplication {
                application { installThrowingRoute(UnmappedTestDomainException(), mapper) }

                val response = client.get("/boom")
                val payload = ObjectMapper().readTree(response.bodyAsText())

                response.status shouldBe HttpStatusCode.Conflict
                payload.get("error").asText() shouldBe "unmapped-error"
            }
        }

        it("defaults unmapped exceptions to 400") {
            testApplication {
                application { installThrowingRoute(UnmappedTestDomainException()) }

                client.get("/boom").status shouldBe HttpStatusCode.BadRequest
            }
        }
    }
})

private fun Application.installThrowingRoute(
    exception: DomainException,
    mapper: DomainExceptionStatusMapper = DefaultDomainExceptionStatusMapper(),
) {
    install(ContentNegotiation) {
        register(ContentType.Application.Json, JacksonConverter(ObjectMapper()))
    }

    installDomainExceptionHandler(mapper)

    routing {
        get("/boom") {
            throw exception
        }
    }
}
