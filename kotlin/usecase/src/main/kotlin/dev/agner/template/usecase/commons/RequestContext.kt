package dev.agner.template.usecase.commons

import kotlinx.coroutines.ThreadContextElement
import org.slf4j.MDC
import java.util.UUID
import kotlin.coroutines.AbstractCoroutineContextElement
import kotlin.coroutines.CoroutineContext

/**
 * The request (and optional job) correlation carried through the coroutine instead of the
 * OTel Baggage. It mirrors itself into MDC so records logged across a suspension still see
 * `request.id`; `docs/observability.md` §3 is the contract.
 */
class RequestContext(
    val requestId: String? = null,
) : AbstractCoroutineContextElement(RequestContext), ThreadContextElement<RequestContext.MdcState> {

    val attributes: Map<String, String>
        get() = requestId?.let { mapOf(TelemetryAttributes.REQUEST_ID to it) }.orEmpty()

    fun requireRequestId(): String = checkNotNull(requestId) { "This context carries no request id" }

    override fun updateThreadContext(context: CoroutineContext): MdcState {
        val previous = MdcState(requestId = MDC.get(TelemetryAttributes.REQUEST_ID))
        for ((key, value) in attributes) {
            MDC.put(key, value)
        }
        return previous
    }

    override fun restoreThreadContext(context: CoroutineContext, oldState: MdcState) {
        restore(TelemetryAttributes.REQUEST_ID, oldState.requestId)
    }

    data class MdcState(val requestId: String?)

    private fun restore(key: String, value: String?) {
        if (value == null) {
            MDC.remove(key)
        } else {
            MDC.put(key, value)
        }
    }

    companion object Key : CoroutineContext.Key<RequestContext> {

        fun resolve(inbound: String?): RequestContext = RequestContext(
            requestId = inbound?.takeIf(TelemetryAttributes.INBOUND_REQUEST_ID::matches) ?: newId(),
        )

        fun newId(): String = UUID.randomUUID().toString()

        val GENERATED_REQUEST_ID = Regex(
            "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
        )
    }
}

val CoroutineContext.requestContext: RequestContext?
    get() = this[RequestContext]
