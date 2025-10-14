package dev.agner.template.usecase.configuration

import com.fasterxml.jackson.annotation.JsonInclude
import com.fasterxml.jackson.core.JsonGenerator
import com.fasterxml.jackson.core.JsonParser
import com.fasterxml.jackson.databind.DeserializationContext
import com.fasterxml.jackson.databind.DeserializationFeature
import com.fasterxml.jackson.databind.JsonDeserializer
import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.databind.JsonSerializer
import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.databind.PropertyNamingStrategies
import com.fasterxml.jackson.databind.SerializationFeature
import com.fasterxml.jackson.databind.SerializerProvider
import com.fasterxml.jackson.databind.module.SimpleModule
import com.fasterxml.jackson.datatype.jsr310.JavaTimeModule
import com.fasterxml.jackson.module.kotlin.registerKotlinModule
import kotlinx.datetime.DatePeriod
import kotlinx.datetime.LocalDate
import org.springframework.context.annotation.Bean
import org.springframework.stereotype.Component

@Component
object JsonMapper {

    val mapper: ObjectMapper = ObjectMapper()
        .registerKotlinModule()
        .registerModule(JavaTimeModule())
        .registerModule(kotlinxDatetimeModule)
        .setDefaultPropertyInclusion(JsonInclude.Include.NON_NULL)
        .setPropertyNamingStrategy(PropertyNamingStrategies.SNAKE_CASE)
        .configure(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES, false)
        .configure(DeserializationFeature.ACCEPT_SINGLE_VALUE_AS_ARRAY, true)
        .configure(SerializationFeature.WRITE_DATES_AS_TIMESTAMPS, false)

    @Bean
    fun jsonAdapter() = mapper
}

private class KotlinxLocalDateSerializer : JsonSerializer<LocalDate>() {
    override fun serialize(value: LocalDate, gen: JsonGenerator, serializers: SerializerProvider) {
        gen.writeString(value.toString())
    }
}

private class KotlinxLocalDateDeserializer : JsonDeserializer<LocalDate>() {
    override fun deserialize(p: JsonParser, ctxt: DeserializationContext): LocalDate {
        val node = p.codec.readTree<JsonNode>(p)
        return LocalDate.parse(node.textValue())
    }
}

private class KotlinxDatePeriodSerializer : JsonSerializer<DatePeriod>() {
    override fun serialize(value: DatePeriod, gen: JsonGenerator, serializers: SerializerProvider) {
        gen.writeString(value.toString())
    }
}

private class KotlinxDatePeriodDeserializer : JsonDeserializer<DatePeriod>() {
    override fun deserialize(p: JsonParser, ctxt: DeserializationContext): DatePeriod {
        val node = p.codec.readTree<JsonNode>(p)
        return DatePeriod.parse(node.textValue())
    }
}

private val kotlinxDatetimeModule = SimpleModule().apply {
    addSerializer(LocalDate::class.java, KotlinxLocalDateSerializer())
    addDeserializer(LocalDate::class.java, KotlinxLocalDateDeserializer())

    addSerializer(DatePeriod::class.java, KotlinxDatePeriodSerializer())
    addDeserializer(DatePeriod::class.java, KotlinxDatePeriodDeserializer())
}
