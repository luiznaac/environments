package dev.agner.template.application.telemetry

import dev.agner.template.usecase.health.HealthTelemetry
import io.opentelemetry.api.OpenTelemetry
import io.opentelemetry.api.metrics.Meter
import io.opentelemetry.instrumentation.logback.appender.v1_0.OpenTelemetryAppender
import org.springframework.beans.factory.DisposableBean
import org.springframework.beans.factory.annotation.Value
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import org.springframework.core.env.Environment

/**
 * The one composition-root seam that builds the OTel SDK, installs the Logback appender and
 * flushes on Spring's shutdown. No `TracerProvider` and no trace exporter are configured.
 */
@Configuration
class TelemetryConfig(
    environment: Environment,
    @Value("\${telemetry.service-name:template}") serviceName: String,
    @Value("\${telemetry.endpoint:}") endpoint: String,
    @Value("\${telemetry.console:false}") console: Boolean,
) : DisposableBean {

    private val settings = TelemetrySettings.resolve(
        activeProfiles = environment.activeProfiles.toList(),
        serviceName = serviceName,
        endpoint = endpoint,
        console = console,
    )

    private val runtime = Telemetry.build(settings)

    init {
        OpenTelemetryAppender.install(runtime.openTelemetry)
    }

    @Bean
    fun openTelemetry(): OpenTelemetry = runtime.openTelemetry

    @Bean
    fun meter(): Meter = Telemetry.meter(runtime.openTelemetry, settings)

    @Bean
    fun healthTelemetry(meter: Meter): HealthTelemetry = HealthTelemetry(meter)

    override fun destroy() {
        runtime.shutdown()
    }
}
