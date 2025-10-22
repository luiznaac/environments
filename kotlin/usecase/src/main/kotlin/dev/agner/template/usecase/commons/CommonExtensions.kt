package dev.agner.template.usecase.commons

import kotlinx.coroutines.Deferred
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.datetime.DateTimeUnit
import kotlinx.datetime.DayOfWeek.SATURDAY
import kotlinx.datetime.DayOfWeek.SUNDAY
import kotlinx.datetime.LocalDate
import kotlinx.datetime.LocalDateTime
import kotlinx.datetime.minus
import kotlinx.datetime.plus
import kotlinx.datetime.toKotlinTimeZone
import kotlinx.datetime.toLocalDateTime
import org.slf4j.Logger
import org.slf4j.LoggerFactory
import java.math.BigDecimal
import java.math.RoundingMode
import java.time.Clock
import kotlin.collections.ArrayList
import kotlin.time.ExperimentalTime
import kotlin.time.toKotlinInstant

inline fun <reified T> T.logger(): Logger = LoggerFactory.getLogger(T::class.java)

inline fun <T, R> Iterable<T>.mapToSet(transformer: (T) -> R) = map(transformer).toSet()

suspend fun <T, R> Iterable<T>.mapAsync(transform: suspend (T) -> R) = coroutineScope {
    map { async { transform(it) } }
}

suspend fun <T, R> Iterable<Deferred<T>>.mapAsyncDeferred(transform: suspend (T) -> R) = coroutineScope {
    map {
        async {
            transform(it.await())
        }
    }
}

suspend fun <T, R> Iterable<Deferred<T>>.onEachAsyncDeferred(transform: suspend (T) -> R) = coroutineScope {
    map {
        async {
            val itt = it.await()
            transform(it.await())
            itt
        }
    }
}

inline fun <T, R> Iterable<T>.foldUntil(initial: R, condition: R.() -> Boolean, operation: (acc: R, T) -> R): R {
    var accumulator = initial
    for (element in this) {
        accumulator = operation(accumulator, element)
        if (condition(accumulator)) break
    }
    return accumulator
}

inline fun <reified R> Iterable<*>.firstOfInstance(): R {
    return filterIsInstanceTo(ArrayList<R>()).firstOrNull()
        ?: throw NoSuchElementException("Collection contains no element of type ${R::class.simpleName}")
}

@OptIn(ExperimentalTime::class)
fun LocalDateTime.Companion.now(clock: Clock) =
    clock.instant().toKotlinInstant().toLocalDateTime(clock.zone.toKotlinTimeZone())

fun LocalDate.Companion.today(clock: Clock) = LocalDateTime.now(clock).date

fun LocalDate.Companion.yesterday(clock: Clock) = LocalDate.today(clock).minus(1, DateTimeUnit.DAY)

fun LocalDate.nextDay() = plus(1, DateTimeUnit.DAY)

fun LocalDate.dayBefore() = minus(1, DateTimeUnit.DAY)

fun LocalDate.isWeekend() = listOf(SATURDAY, SUNDAY).contains(dayOfWeek)

fun LocalDate.toMondayIfWeekend() = when (dayOfWeek) {
    SATURDAY -> nextDay().nextDay()
    SUNDAY -> nextDay()
    else -> this
}

fun BigDecimal.defaultScale() = setScale(2, RoundingMode.HALF_EVEN)
