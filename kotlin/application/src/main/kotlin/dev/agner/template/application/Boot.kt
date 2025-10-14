package dev.agner.template.application

import org.springframework.boot.runApplication
import org.springframework.context.annotation.ComponentScan
import org.springframework.context.annotation.Configuration

@Configuration
@ComponentScan(basePackages = ["dev.agner.template"])
class Boot

fun main() {
    runApplication<Boot>()
}
