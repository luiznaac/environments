package dev.agner.template.application.telemetry

import ch.qos.logback.classic.Level
import ch.qos.logback.classic.spi.ILoggingEvent
import ch.qos.logback.core.pattern.DynamicConverter
import com.fasterxml.jackson.core.JsonGenerator
import dev.agner.template.usecase.commons.TelemetryAttributes
import net.logstash.logback.composite.AbstractJsonProvider
import java.time.Instant

/**
 * The pinned single-line JSON fields. MDC entries (attributes, `request.id`, `event.name`)
 * are written by logstash's `MdcJsonProvider`; these providers pin the record's own fields and
 * stamp `event.name` from the body for a plain framework log that carries none.
 */
object TelemetryJsonProviders {

    private val SEVERITY_NUMBERS = mapOf(
        Level.TRACE to 1,
        Level.DEBUG to 5,
        Level.INFO to 9,
        Level.WARN to 13,
        Level.ERROR to 17,
    )

    class TimestampJsonProvider : AbstractJsonProvider<ILoggingEvent>() {
        override fun writeTo(generator: JsonGenerator, event: ILoggingEvent) {
            generator.writeStringField("timestamp", Instant.ofEpochMilli(event.timeStamp).toString())
        }
    }

    class ObservedTimestampJsonProvider : AbstractJsonProvider<ILoggingEvent>() {
        override fun writeTo(generator: JsonGenerator, event: ILoggingEvent) {
            generator.writeStringField("observed_timestamp", Instant.now().toString())
        }
    }

    class SeverityTextJsonProvider : AbstractJsonProvider<ILoggingEvent>() {
        override fun writeTo(generator: JsonGenerator, event: ILoggingEvent) {
            generator.writeStringField("severity_text", event.level.toString())
        }
    }

    class SeverityNumberJsonProvider : AbstractJsonProvider<ILoggingEvent>() {
        override fun writeTo(generator: JsonGenerator, event: ILoggingEvent) {
            generator.writeNumberField("severity_number", SEVERITY_NUMBERS[event.level] ?: 0)
        }
    }

    class BodyJsonProvider : AbstractJsonProvider<ILoggingEvent>() {
        override fun writeTo(generator: JsonGenerator, event: ILoggingEvent) {
            generator.writeStringField("body", event.formattedMessage)
        }
    }

    class EventNameJsonProvider : AbstractJsonProvider<ILoggingEvent>() {
        override fun writeTo(generator: JsonGenerator, event: ILoggingEvent) {
            val eventName = event.mdcPropertyMap[TelemetryAttributes.EVENT_NAME] ?: event.formattedMessage
            generator.writeStringField(TelemetryAttributes.EVENT_NAME, eventName)
        }
    }

    class ResourceJsonProvider : AbstractJsonProvider<ILoggingEvent>() {
        override fun writeTo(generator: JsonGenerator, event: ILoggingEvent) {
            generator.writeObjectFieldStart("resource")
            for ((key, value) in TelemetryResourceValues.attributes) {
                generator.writeStringField(key, value)
            }
            generator.writeEndObject()
        }
    }

    class ResourceConverter : DynamicConverter<ILoggingEvent>() {
        override fun convert(event: ILoggingEvent): String = TelemetryResourceValues.attributes
            .entries
            .joinToString(prefix = "{", postfix = "}") { "${it.key}=${it.value}" }
    }
}
