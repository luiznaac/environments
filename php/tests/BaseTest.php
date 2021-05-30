<?php

namespace Tests;

use PHPUnit\Framework\TestCase;
use Src\Base;

class BaseTest extends TestCase {

	public function test(): void {
		$base = new Base();
		$this->assertTrue($base->baseResponse());
	}
}
