var msg;

function speak(string)	{
	msg = new SpeechSynthesisUtterance(string);
	window.speechSynthesis.speak(msg);
}

function cancelSpeak()	{
	window.speechSynthesis.cancel();
}