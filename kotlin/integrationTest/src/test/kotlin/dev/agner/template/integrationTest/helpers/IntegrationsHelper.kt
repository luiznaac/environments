package dev.agner.template.integrationTest.helpers

import io.kotest.extensions.spring.testContextManager

suspend inline fun <reified T> getBean(): T =
    testContextManager().testContext.applicationContext.getBean(T::class.java)
