dependencies {
    implementation(project(":usecase"))

    implementation(libs.spring.context)
    implementation(libs.exposed.core)
    implementation(libs.exposed.dao)
    implementation(libs.exposed.jdbc)
    implementation(libs.exposed.datetime)
    implementation("com.mysql:mysql-connector-j:9.4.0")
}
