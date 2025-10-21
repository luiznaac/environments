package dev.agner.template.usecase.configuration.serializers

import com.fasterxml.jackson.core.JsonGenerator
import com.fasterxml.jackson.core.JsonParser
import com.fasterxml.jackson.databind.DeserializationContext
import com.fasterxml.jackson.databind.JsonDeserializer
import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.databind.JsonSerializer
import com.fasterxml.jackson.databind.SerializerProvider
import com.fasterxml.jackson.databind.module.SimpleModule
import org.springframework.scheduling.support.CronExpression

class CronExpressionModule : SimpleModule() {
    init {
        addSerializer(
            CronExpression::class.java,
            object : JsonSerializer<CronExpression>() {
                override fun serialize(value: CronExpression, gen: JsonGenerator, serializers: SerializerProvider) {
                    gen.writeString(value.toString().replaceFirst("0 ", ""))
                }
            },
        )
        addDeserializer(
            CronExpression::class.java,
            object : JsonDeserializer<CronExpression>() {
                override fun deserialize(p: JsonParser, ctxt: DeserializationContext) =
                    CronExpression.parse("0 " + p.codec.readTree<JsonNode>(p).textValue())
            },
        )
    }
}
