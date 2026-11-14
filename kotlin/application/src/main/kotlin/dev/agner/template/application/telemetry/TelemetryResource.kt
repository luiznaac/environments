package dev.agner.template.application.telemetry

import dev.agner.template.usecase.commons.TelemetryAttributes
import io.opentelemetry.api.common.AttributeKey
import io.opentelemetry.sdk.resources.Resource

/**
 * The six resource attributes every record carries. They are set once on the SDK resource —
 * never per call site — and a missing env var still yields a valid resource.
 */
object TelemetryResource {

    fun of(settings: TelemetrySettings): Resource {
        val builder = Resource.getDefault().toBuilder()
        for ((key, value) in attributesOf(settings)) {
            builder.put(AttributeKey.stringKey(key), value)
        }
        for ((key, value) in settings.resourceAttributes) {
            builder.put(AttributeKey.stringKey(key), value)
        }
        return builder.build()
    }

    fun attributesOf(settings: TelemetrySettings): Map<String, String> = mapOf(
        TelemetryAttributes.SERVICE_NAME to settings.serviceName,
        TelemetryAttributes.SERVICE_NAMESPACE to TelemetrySettings.SERVICE_NAMESPACE,
        TelemetryAttributes.SERVICE_VERSION to settings.version,
        TelemetryAttributes.DEPLOYMENT_ENVIRONMENT_NAME to settings.environment,
        TelemetryAttributes.SERVICE_INSTANCE_ID to settings.instanceId,
        TelemetryAttributes.HOST_NAME to settings.hostName,
    )
}

/**
 * The six resource values in the form the stdout renderers need. The SDK owns the canonical
 * resource; this mirror exists because the Logback console and JSON encoders cannot read it.
 */
object TelemetryResourceValues {

    @Volatile
    private var _values: Map<String, String> = emptyMap()

    fun install(settings: TelemetrySettings) {
        _values = TelemetryResource.attributesOf(settings)
    }

    val attributes: Map<String, String>
        get() = _values
}
