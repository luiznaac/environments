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
    )
}

val writeBuildInfo by tasks.registering(WriteProperties::class) {
    destinationFile.set(layout.buildDirectory.file("generated/build-info/build-info.properties"))
    property("version", project.version.toString())
}

sourceSets.main {
    resources.srcDir(layout.buildDirectory.dir("generated/build-info"))
}

tasks.processResources {
    dependsOn(writeBuildInfo)
}

dependencies {
    implementation(project(":http-api"))
    implementation(project(":persistence"))
    implementation(project(":usecase"))
    implementation(project(":gateway"))

    implementation(libs.spring.boot)
    implementation(libs.snakeyaml)
    implementation(libs.logback.classic)

    implementation(libs.opentelemetry.sdk)
    implementation(libs.opentelemetry.exporter.otlp)
    implementation(libs.opentelemetry.exporter.logging)
    implementation(libs.opentelemetry.runtime.telemetry)
    implementation(libs.opentelemetry.logback.appender)
    implementation(libs.logstash.logback.encoder)

    testImplementation(libs.bundles.testDependencies)
    testImplementation(libs.opentelemetry.sdk.testing)
}
