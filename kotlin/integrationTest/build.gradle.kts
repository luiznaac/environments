dependencies {
    testImplementation(project(":application"))
    // MigrationSchemaTest uses :persistence's `allTables` directly; persistence declares it as
    // `implementation`, so the edge is explicit rather than transitive.
    testImplementation(project(":persistence"))
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
    // Same reason: the test calls Database.connect/transaction/MigrationUtils directly.
    testImplementation(libs.exposed.core)
    testImplementation(libs.exposed.jdbc)
    testImplementation(libs.exposed.migration.core)
    testImplementation(libs.exposed.migration.jdbc)
}
