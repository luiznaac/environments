package dev.agner.template.usecase.configuration

import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import java.time.Clock

@Configuration
class TimeProviderConfig {

    @Bean
    fun timeProvider(): Clock = Clock.systemDefaultZone()
}
