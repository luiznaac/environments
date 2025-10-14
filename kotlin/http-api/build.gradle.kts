dependencies {
    implementation(project(":usecase"))

    implementation(libs.bundles.dependencies)

    implementation(libs.ktor.core)
    implementation(libs.ktor.netty)
    implementation(libs.ktor.compression)
    implementation(libs.ktor.cors)
    implementation(libs.ktor.status.pages)
    implementation(libs.ktor.content.negotiation)
    implementation(libs.ktor.jackson)

    testImplementation(libs.bundles.testDependencies)
}
