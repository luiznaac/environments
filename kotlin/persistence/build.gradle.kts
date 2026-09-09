dependencies {
    implementation(project(":usecase"))

    implementation(libs.spring.context)
    implementation(libs.exposed.core)
    implementation(libs.exposed.dao)
    implementation(libs.exposed.jdbc)
    implementation(libs.exposed.datetime)
    implementation("com.mysql:mysql-connector-j:9.4.0")
    implementation("org.flywaydb:flyway-core:10.21.0")
    implementation("org.flywaydb:flyway-mysql:10.21.0")
}

tasks.register("generateMigrationScript") {
    doLast {
        println("Migration generation task - extend this to run Exposed's migration generator")
        println("See chameidor/portfolio-2 for the full implementation")
    }
}

tasks.register("migrate") {
    doLast {
        println("To apply migrations locally, run:")
        println("  MYSQL_HOST=localhost MYSQL_USER=root MYSQL_PASSWORD= java -cp lib/* dev.agner.template.persistence.migration.MigratorKt")
    }
}
