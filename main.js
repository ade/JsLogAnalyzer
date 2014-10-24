var searchButton = document.querySelector('#searchbutton');
var cursorPositionLabel = document.querySelector('#cursor_position');
var resultCountLabel = document.querySelector('#result_count');
var readFrom = document.querySelector("#read-from");
var readTo = document.querySelector("#read-to");
var filePicker = document.querySelector("#files");
var progressBar = document.querySelector("#progress-bar");
var fileSize;
var fileReadEndTime;

var workerCount = 4;
var workers = [];
for(var i = 0; i < workerCount; i++) {
	var worker = {
		worker: new Worker("chunk_task.js"),
		busy: false
	};
	workers.push(worker);
	worker.worker.postMessage({
		action: 'init',
		workerIndex: i
	});
}

var setSliderLabels = function setSliderValues() {
	document.querySelector('#read-from-label').textContent = bytesToSize(readFrom.value);
	document.querySelector('#read-to-label').textContent = bytesToSize(readTo.value);
};

readFrom.addEventListener('change', setSliderLabels);
readTo.addEventListener('change', setSliderLabels);

filePicker.addEventListener('change', function() {
	fileSize = getFileSize();
	readFrom.disabled = false;
	readTo.disabled = false;
	readFrom.max = fileSize-2;
	readTo.max = fileSize-1;

	var defaultValue = Math.min(fileSize, 1024*1024*300);

	readFrom.value = 0;
	readTo.value = defaultValue;

	setSliderLabels();
});

function getFileSize() {
	var files = document.getElementById('files').files;
	if (files.length) {
		return files[0].size;
	} else {
		throw new Error('No file');
	}
}

var Search = function(startIndex, limitIndex, forward) {
	var position = startIndex;
	var deferred = Q.defer();
	var SEARCH_FRAME_SIZE = 64 * 1024 * 1024;
	var query = document.querySelector('#pattern').value;
	var direction = forward ? 1 : -1;
	var searchStartedAt = new Date();
	var sizeOfMatchedData = 0;
	var resultCount = 0;
	var matches = [];
	var keys = [];
	var lineCount = 0;
	var bytesProcessed = 0;
	var timeSpentParsing = 0;



	var onWorkerEvent = function onWorkerEvent(event) {
		if(event.data === 'parsePhase') {
			if(position < limitIndex) {
				delegateWork();
			}
			return;
		}

		var msg = event.data;
		var index = msg.workerIndex;

		workers[index].busy = false;

		msg.keys.forEach(function(key) {
			matches[key] = msg.matches[key];
			keys.push(key);
		});

		var workerString = "";
		var workersWorking = false;
		workers.forEach(function(worker) {
			if(worker.busy) {
				workerString += "A,";
				workersWorking = true;
			} else {
				workerString += "-,";
			}
		});

		progressBar.value = bytesProcessed;
		cursorPositionLabel.textContent = bytesToSize(position) + ", parsed " + lineCount + " entries [" + workerString + "]";
		resultCountLabel.textContent = resultCount + " (" + bytesToSize(sizeOfMatchedData) + ")";
		timeSpentParsing += new Date() - fileReadEndTime;


		if(!workersWorking && position > limitIndex) {
			finish();
		}

	};

	var getAvailableWorker = function getAvailableWorker() {
		var ret = null;
		workers.forEach(function(worker) {
			if(!worker.busy) {
				ret = worker;
			}
		});
		return ret;
	};

	var readNext = function(worker) {
		worker.busy = true;
		worker.worker.onmessage = onWorkerEvent;
		worker.worker.postMessage({
			action: 'do',
			startIndex: position,
			endIndex: position + (SEARCH_FRAME_SIZE * direction),
			query: query,
			file: filePicker.files[0]
		});
		position += SEARCH_FRAME_SIZE * direction;
		bytesProcessed += SEARCH_FRAME_SIZE;
	};

	var delegateWork = function delegateWork() {
		var worker = getAvailableWorker();
		readNext(worker);
	};

	var finish = function() {
		deferred.resolve({
			timeTakenMs: new Date() - searchStartedAt,
			entriesSearched: lineCount,
			bytesSearched: Math.abs(startIndex - limitIndex),
			matchesDictionary: matches,
			timeSpentParsing: timeSpentParsing,
			keys: keys
		});
	};

	this.search = function search() {


		delegateWork();

		return deferred.promise;
	}
};

var bytesToSize = function bytesToSize(bytes) {
	var sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
	if (bytes == 0) return '0 Byte';
	var i = parseInt(Math.floor(Math.log(bytes) / Math.log(1024)));
	return Math.round((bytes / Math.pow(1024, i) * 100)) / 100 + ' ' + sizes[i];
};

var presentResults = function presentResults(results) {
	var outputbox = document.querySelector("#fancy_output");
	var matches = results.matchesDictionary;
	var fragment = document.createDocumentFragment();
	var source   = document.querySelector("#line-template").innerHTML;
	var template = Handlebars.compile(source);

	results.keys.forEach(function(key) {
		var result = matches[key];
		var container = document.createElement("div");
		container.style.background = randomColorString();
		fragment.appendChild(container);

		result.forEach(function(lineObject) {
			container.innerHTML += template(lineObject);
		});
	});
	outputbox.innerHTML = '';
	outputbox.appendChild(fragment);
};

function randomColorString () {
	function randomColor () {
		return ( Math.round( Math.random() * 127 ) + 127 ).toString( 16 );
	}
	var r = randomColor(),
		g = randomColor(),
		b = randomColor();
	return '#' + r + g + b;
}

searchButton.addEventListener('click', function() {
	searchButton.textContent = 'Searching...';
	searchButton.disabled = true;
	var start = parseInt(readFrom.value, 10);
	var end = parseInt(readTo.value, 10);
	if(start > end) {
		alert('invalid start/stop values');
		return;
	}
	end = Math.min(fileSize, end);

	progressBar.max = end - start;

	var searcher = new Search(start, end, true);

	searcher.search()
		.then(function(e) {
			var entrySpeed = Math.round((e.entriesSearched / (e.timeTakenMs / 1000)) / 1000);

			var byteSpeed = bytesToSize(e.bytesSearched / (e.timeTakenMs / 1000));
			cursorPositionLabel.textContent = e.entriesSearched + " entries searched in " + Math.round(e.timeTakenMs/1000) + " sec (" + entrySpeed + "k entries/sec, " + byteSpeed + "/sec), time spent parsing: " + e.timeSpentParsing;

			searchButton.textContent = 'Search';
			searchButton.disabled = false;

			presentResults(e);
		})
		.fail(function() {
			cursorPositionLabel.textContent = "Failed";
			searchButton.textContent = 'Search';
			searchButton.disabled = false;
		});
}, false);
