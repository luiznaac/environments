dependencies {
    testImplementation(project(":application"))
    testImplementation(project(":http-api"))
    testImplementation(project(":gateway"))
    testImplementation(project(":usecase"))
    testImplementation(libs.bundles.testDependencies)
    testImplementation(libs.kotest.extensions.spring)
    testImplementation(libs.ktor.client.core)
    testImplementation(libs.spring.boot.starter.test)
    testImplementation(libs.testcontainers)
    testImplementation(libs.wiremock)
    implementation(libs.jackson.kotlin)
}
