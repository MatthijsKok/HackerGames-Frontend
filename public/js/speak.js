function speak(string)	{
	var msg = new SpeechSynthesisUtterance(string);
	window.speechSynthesis.speak(msg);
}