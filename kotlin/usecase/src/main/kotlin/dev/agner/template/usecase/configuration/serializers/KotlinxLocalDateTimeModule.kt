package dev.agner.template.usecase.configuration.serializers

import com.fasterxml.jackson.core.JsonGenerator
import com.fasterxml.jackson.core.JsonParser
import com.fasterxml.jackson.databind.DeserializationContext
import com.fasterxml.jackson.databind.JsonDeserializer
import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.databind.JsonSerializer
import com.fasterxml.jackson.databind.SerializerProvider
import com.fasterxml.jackson.databind.module.SimpleModule
import kotlinx.datetime.LocalDateTime

class KotlinxLocalDateTimeModule : SimpleModule() {
    init {
        addSerializer(
            LocalDateTime::class.java,
            object : JsonSerializer<LocalDateTime>() {
                override fun serialize(value: LocalDateTime, gen: JsonGenerator, serializers: SerializerProvider) {
                    gen.writeString(value.toString())
                }
            },
        )
        addDeserializer(
            LocalDateTime::class.java,
            object : JsonDeserializer<LocalDateTime>() {
                override fun deserialize(p: JsonParser, ctxt: DeserializationContext) =
                    LocalDateTime.parse(p.codec.readTree<JsonNode>(p).textValue())
            },
        )
    }
}
