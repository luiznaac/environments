package dev.agner.template.usecase

import io.kotest.property.Arb
import io.kotest.property.arbitrary.Codepoint
import io.kotest.property.arbitrary.ascii
import io.kotest.property.arbitrary.boolean
import io.kotest.property.arbitrary.double
import io.kotest.property.arbitrary.enum
import io.kotest.property.arbitrary.filter
import io.kotest.property.arbitrary.int
import io.kotest.property.arbitrary.next
import io.kotest.property.arbitrary.string
import io.kotest.property.arbitrary.take
import java.math.BigDecimal

fun int() = Arb.int().next()

fun bigDecimal() = BigDecimal(Arb.double().next())

fun boolean() = Arb.boolean().next()

fun string() = Arb.string().next()

fun nonBlankString() = Arb.string().filter(String::isNotBlank).next()

fun byteArray() = string().toByteArray()

fun <T> Arb<T>.toSet(size: Int = 5) = this.take(size).toSet()

inline fun <reified E : Enum<E>> enum() = Arb.enum<E>().next()

fun arbAsciiString() = Arb.string(codepoints = Codepoint.ascii(), size = 20).next()
