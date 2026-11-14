package dev.agner.template.usecase.commons

import org.slf4j.Logger
import org.slf4j.MDC

enum class EventLevel { DEBUG, INFO, WARN, ERROR }

/**
 * Logs a stable `<domain>.<action>` event: the message is the event name, the attributes ride
 * in MDC for the duration of the call, and `event.name` is stamped beside them. The scope is
 * cleared synchronously, so a coroutine suspension cannot leak an attribute into the next
 * log line. `docs/observability.md` §2 is the contract.
 */
fun Logger.event(
    name: String,
    vararg attributes: Pair<String, Any?>,
    level: EventLevel = EventLevel.INFO,
    throwable: Throwable? = null,
) {
    val previous = (attributes.map { it.first } + TelemetryAttributes.EVENT_NAME)
        .associateWith { MDC.get(it) }
    try {
        MDC.put(TelemetryAttributes.EVENT_NAME, name)
        for ((key, value) in attributes) {
            if (value == null) {
                MDC.remove(key)
            } else {
                MDC.put(key, value.toString())
            }
        }
        write(level, name, throwable)
    } finally {
        for ((key, value) in previous) {
            if (value == null) {
                MDC.remove(key)
            } else {
                MDC.put(key, value)
            }
        }
    }
}

private fun Logger.write(level: EventLevel, name: String, throwable: Throwable?) {
    when (level) {
        EventLevel.DEBUG -> if (throwable == null) debug(name) else debug(name, throwable)
        EventLevel.INFO -> if (throwable == null) info(name) else info(name, throwable)
        EventLevel.WARN -> if (throwable == null) warn(name) else warn(name, throwable)
        EventLevel.ERROR -> if (throwable == null) error(name) else error(name, throwable)
    }
}
