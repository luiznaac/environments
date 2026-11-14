dependencies {
    implementation(libs.logback.classic)
    implementation(libs.spring.context)
    implementation(libs.bundles.dependencies)
    implementation(libs.jackson.kotlin)
    implementation(libs.jackson.jsr310)
    implementation(libs.kotlin.reflect)
    implementation(libs.opentelemetry.api)

    testImplementation(libs.bundles.testDependencies)
    testImplementation(libs.opentelemetry.sdk.testing)

    testFixturesImplementation(libs.bundles.testDependencies)
}
