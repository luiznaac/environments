package dev.agner.template.usecase.configuration.serializers

import com.fasterxml.jackson.core.JsonGenerator
import com.fasterxml.jackson.core.JsonParser
import com.fasterxml.jackson.databind.DeserializationContext
import com.fasterxml.jackson.databind.JsonDeserializer
import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.databind.JsonSerializer
import com.fasterxml.jackson.databind.SerializerProvider
import com.fasterxml.jackson.databind.module.SimpleModule
import kotlinx.datetime.LocalDate

class KotlinxLocalDateModule : SimpleModule() {
    init {
        addSerializer(
            LocalDate::class.java,
            object : JsonSerializer<LocalDate>() {
                override fun serialize(value: LocalDate, gen: JsonGenerator, serializers: SerializerProvider) {
                    gen.writeString(value.toString())
                }
            },
        )
        addDeserializer(
            LocalDate::class.java,
            object : JsonDeserializer<LocalDate>() {
                override fun deserialize(p: JsonParser, ctxt: DeserializationContext) =
                    LocalDate.parse(p.codec.readTree<JsonNode>(p).textValue())
            },
        )
    }
}
