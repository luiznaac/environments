package dev.agner.template.usecase.commons

/**
 * Attribute and field names shared by the log record, the metrics catalog and the request
 * correlation contract in `docs/observability.md`. Values are the semconv spelling verbatim.
 */
object TelemetryAttributes {

    const val EVENT_NAME = "event.name"
    const val REQUEST_ID = "request.id"
    const val REQUEST_ID_HEADER = "X-Request-ID"

    const val HTTP_REQUEST_METHOD = "http.request.method"
    const val HTTP_ROUTE = "http.route"
    const val URL_PATH = "url.path"
    const val URL_SCHEME = "url.scheme"
    const val HTTP_RESPONSE_STATUS_CODE = "http.response.status_code"
    const val NETWORK_PROTOCOL_VERSION = "network.protocol.version"
    const val SERVER_ADDRESS = "server.address"
    const val SERVER_PORT = "server.port"
    const val ERROR_TYPE = "error.type"

    const val HEALTH_COMPONENT = "health.component"

    const val RESOURCE_NOT_FOUND = "resource_not_found"
    const val INVALID_ARGUMENT = "invalid_argument"
    const val DOMAIN_ERROR = "domain_error"

    const val SERVICE_NAME = "service.name"
    const val SERVICE_NAMESPACE = "service.namespace"
    const val SERVICE_VERSION = "service.version"
    const val DEPLOYMENT_ENVIRONMENT_NAME = "deployment.environment.name"
    const val SERVICE_INSTANCE_ID = "service.instance.id"
    const val HOST_NAME = "host.name"

    val INBOUND_REQUEST_ID = Regex("^[A-Za-z0-9._-]{8,128}$")
}
