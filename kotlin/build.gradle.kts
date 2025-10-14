import io.gitlab.arturbosch.detekt.Detekt
import org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_21

plugins {
	jacoco
	kotlin("jvm") version "2.2.20"
	kotlin("plugin.spring") version "2.2.20"
	id("io.gitlab.arturbosch.detekt") version "1.23.8"
	id("io.spring.dependency-management") version "1.1.7"
}

allprojects {
	buildscript {
		repositories {
			gradlePluginPortal()
			mavenCentral()
		}
	}

	repositories {
		mavenCentral()
	}
}

subprojects {
	group = "dev.agner.template"
	version = "1.0"

	apply(plugin = "kotlin")
	apply(plugin = "jacoco")
	apply(plugin = "kotlin-spring")
	apply(plugin = "java-test-fixtures")
	apply(plugin = "io.gitlab.arturbosch.detekt")

	dependencies {
		detektPlugins("io.gitlab.arturbosch.detekt:detekt-formatting:1.23.8")
	}

	jacoco {
		toolVersion = "0.8.13"
	}

	tasks.jacocoTestReport {
		dependsOn(tasks.test)
		reports {
			xml.required.set(true)
			csv.required.set(false)
			html.required.set(true)
		}
		finalizedBy(tasks.jacocoTestCoverageVerification)
	}

	tasks.withType<Detekt> {
		parallel = true
		disableDefaultRuleSets = true
		buildUponDefaultConfig = true
		autoCorrect = true
		ignoreFailures = false
		setSource(files(projectDir))
		include("*/.kt", "*/.kts")
		config.setFrom(files("$rootDir/config/detekt/config.yml", "$rootDir/config/detekt/format.yml"))
		reports {
			xml.required.set(false)
			html.required.set(true)
		}
	}

	kotlin {
		compilerOptions {
			jvmTarget.set(JVM_21)
			allWarningsAsErrors.set(true)
			freeCompilerArgs.add("-Xjvm-default=all")
		}
	}

	java {
		toolchain {
			languageVersion = JavaLanguageVersion.of(21)
		}
	}

	tasks.withType<Test> {
		useJUnitPlatform()
		testLogging {
			events("passed", "skipped", "failed")
		}
	}
}

repositories {
	mavenCentral()
}

// Root project JaCoCo aggregation configuration
jacoco {
	toolVersion = "0.8.13"
}

// Create an aggregated coverage report
tasks.register<JacocoReport>("codeCoverageReport") {
	dependsOn(subprojects.map { it.tasks.named("jacocoTestReport") })

	executionData.setFrom(subprojects.map {
		fileTree("${it.layout.buildDirectory}/jacoco").include("**/*.exec")
	})

	classDirectories.setFrom(subprojects.map {
		fileTree("${it.layout.buildDirectory}/classes/kotlin/main")
	})

	sourceDirectories.setFrom(subprojects.map {
		it.file("src/main/kotlin")
	})

	reports {
		xml.required.set(true)
		html.required.set(true)
		csv.required.set(false)
	}
}

// Create a task to run all tests and generate coverage
tasks.register("testCoverageReport") {
	group = "verification"
	description = "Runs all tests and generates aggregated coverage report"
	dependsOn(subprojects.map { it.tasks.named("test") })
	finalizedBy("codeCoverageReport")
}
