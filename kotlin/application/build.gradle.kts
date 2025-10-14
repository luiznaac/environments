plugins {
    application
}

application {
    mainClass.set("dev.agner.template.application.BootKt")
    applicationDefaultJvmArgs = listOf(
        "-server",
        "-XX:+UseNUMA",
        "-XX:+UseG1GC",
        "-XX:+UseStringDeduplication",
        "-Duser.timezone=Etc/UTC",
    )
}

dependencies {
    implementation(project(":http-api"))
    implementation(project(":persistence"))
    implementation(project(":usecase"))
    implementation(project(":gateway"))

    implementation(libs.spring.boot)
    implementation(libs.snakeyaml)
}
