package dev.agner.template.usecase.commons

abstract class DomainException(
    val error: String,
    val userMessage: String,
    val detail: String,
) : RuntimeException(detail)
