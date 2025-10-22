package dev.agner.template.integrationTest.config

import io.mockk.every
import io.mockk.mockk
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Primary
import org.springframework.stereotype.Component
import java.time.Clock
import java.time.ZoneId

@Component
object ClockMock {

    val clock = mockk<Clock> {
        every { zone } returns ZoneId.systemDefault()
    }

    @Bean
    @Primary
    fun clock() = clock
}
