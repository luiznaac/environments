package dev.agner.template.integrationTest.config

import com.github.tomakehurst.wiremock.WireMockServer
import com.github.tomakehurst.wiremock.client.WireMock
import com.github.tomakehurst.wiremock.http.RequestMethod
import dev.agner.template.usecase.configuration.JsonMapper

object HttpMockService {

    private val server = WireMockServer(3000)
    private val mapper = JsonMapper.mapper

    init {
        server.start()
    }

    class ResponseConfiguration {
        lateinit var method: RequestMethod
        lateinit var endpoint: String
        var queryParams: Map<String, String> = emptyMap()
        var httpStatus: Int = 200
        var payload: Any = emptyMap<String, String>()
    }

    class ResponseScope {
        val responses = mutableSetOf<ResponseConfiguration>()

        suspend fun response(configure: suspend ResponseConfiguration.() -> Unit) {
            responses += ResponseConfiguration().apply { configure() }
        }
    }

    suspend fun configureResponses(scope: suspend ResponseScope.() -> Unit) {
        ResponseScope()
            .apply { scope() }
            .responses
            .forEach { configuration ->
                mockFor(
                    method = configuration.method,
                    endpoint = configuration.endpoint,
                    queryParams = configuration.queryParams,
                    httpStatus = configuration.httpStatus,
                    desiredResponsePayload = configuration.payload,
                )
            }
    }

    private fun mockFor(
        method: RequestMethod,
        endpoint: String,
        queryParams: Map<String, String>,
        httpStatus: Int,
        desiredResponsePayload: Any,
    ) {
        server.stubFor(
            WireMock.request(method.value(), WireMock.urlPathMatching(endpoint))
                .apply {
                    queryParams.forEach { (key, value) -> withQueryParam(key, WireMock.equalTo(value)) }
                }
                .willReturn(
                    WireMock.aResponse()
                        .withHeader("Content-Type", "application/json")
                        .withStatus(httpStatus)
                        .withBody(mapper.writeValueAsBytes(desiredResponsePayload)),
                ),
        )
    }

    fun clearMocks() {
        server.resetAll()
    }
}
