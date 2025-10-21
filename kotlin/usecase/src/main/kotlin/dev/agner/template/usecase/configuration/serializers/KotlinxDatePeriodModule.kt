package dev.agner.template.usecase.configuration.serializers

import com.fasterxml.jackson.core.JsonGenerator
import com.fasterxml.jackson.core.JsonParser
import com.fasterxml.jackson.databind.DeserializationContext
import com.fasterxml.jackson.databind.JsonDeserializer
import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.databind.JsonSerializer
import com.fasterxml.jackson.databind.SerializerProvider
import com.fasterxml.jackson.databind.module.SimpleModule
import kotlinx.datetime.DatePeriod

class KotlinxDatePeriodModule : SimpleModule() {
    init {
        addSerializer(
            DatePeriod::class.java,
            object : JsonSerializer<DatePeriod>() {
                override fun serialize(value: DatePeriod, gen: JsonGenerator, serializers: SerializerProvider) {
                    gen.writeString(value.toString())
                }
            },
        )
        addDeserializer(
            DatePeriod::class.java,
            object : JsonDeserializer<DatePeriod>() {
                override fun deserialize(p: JsonParser, ctxt: DeserializationContext) =
                    DatePeriod.parse(p.codec.readTree<JsonNode>(p).textValue())
            },
        )
    }
}
