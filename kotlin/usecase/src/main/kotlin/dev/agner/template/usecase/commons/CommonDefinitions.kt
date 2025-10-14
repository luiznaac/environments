package dev.agner.template.usecase.commons

import kotlinx.datetime.LocalDate
import kotlinx.datetime.format.FormatStringsInDatetimeFormats
import kotlinx.datetime.format.byUnicodePattern

@OptIn(FormatStringsInDatetimeFormats::class)
val brazilianLocalDateFormat = LocalDate.Format { byUnicodePattern("dd/MM/yyyy") }

@OptIn(FormatStringsInDatetimeFormats::class)
val disgustingLocalDateFormat = LocalDate.Format { byUnicodePattern("M/d/yy") }
