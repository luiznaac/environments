package dev.agner.template.application.telemetry

import ch.qos.logback.classic.Level
import ch.qos.logback.classic.Logger
import ch.qos.logback.classic.turbo.TurboFilter
import ch.qos.logback.core.spi.FilterReply
import org.slf4j.MDC
import org.slf4j.Marker

/**
 * The single redaction chokepoint: it runs before either appender snapshots the MDC, so the
 * OTLP record and the stdout line cannot diverge. A scalar secret value becomes
 * `[REDACTED]` with its key kept; a secret-bearing container and a body are dropped.
 */
class RedactingMdcFilter : TurboFilter() {

    override fun decide(
        marker: Marker?,
        logger: Logger?,
        level: Level?,
        format: String?,
        params: Array<out Any>?,
        throwable: Throwable?,
    ): FilterReply {
        val current = MDC.getCopyOfContextMap() ?: return FilterReply.NEUTRAL
        val redacted = Redaction.redact(current)
        if (redacted != current) {
            MDC.clear()
            for ((key, value) in redacted) {
                MDC.put(key, value)
            }
        }
        return FilterReply.NEUTRAL
    }
}

object Redaction {

    const val REDACTED = "[REDACTED]"

    private val secretKeyFragments = listOf(
        "password",
        "passphrase",
        "secret",
        "token",
        "api_key",
        "apikey",
        "private_key",
        "session",
        "credential",
        "authorization",
        "cookie",
        "connection_string",
    )

    fun redact(mdc: Map<String, String>): Map<String, String> = buildMap {
        for ((key, value) in mdc) {
            val normalized = key.lowercase().replace('.', '_')
            when {
                isBody(normalized) -> Unit
                isSecret(normalized) -> if (!isContainer(value)) put(key, REDACTED)
                else -> put(key, value)
            }
        }
    }

    private fun isBody(key: String) = key == "body" || key.endsWith(".body") || key.endsWith("_body")

    private fun isSecret(key: String) = secretKeyFragments.any(key::contains)

    private fun isContainer(value: String): Boolean {
        val trimmed = value.trimStart()
        return trimmed.startsWith('{') || trimmed.startsWith('[')
    }
}
