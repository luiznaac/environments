dependencies {
    implementation(libs.logback.classic)
    implementation(libs.spring.context)
    implementation(libs.bundles.dependencies)
    implementation(libs.jackson.kotlin)
    implementation(libs.jackson.jsr310)
    implementation(libs.kotlin.reflect)

    testImplementation(libs.bundles.testDependencies)

    testFixturesImplementation(libs.bundles.testDependencies)
}
