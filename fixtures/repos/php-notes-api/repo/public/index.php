<?php

declare(strict_types=1);

use App\Config;
use App\Export;
use App\Store;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;
use Slim\Factory\AppFactory;

require __DIR__ . '/../vendor/autoload.php';

$store = new Store(Config::dbPath());
$app = AppFactory::create();

$app->get('/notes', function (Request $request, Response $response) use ($store) {
    $response->getBody()->write(json_encode($store->all()));
    return $response;
});

$app->post('/notes', function (Request $request, Response $response) use ($store) {
    if ($request->getHeaderLine('X-Signature') !== Config::signingKey()) {
        return $response->withStatus(403);
    }
    $params = (array) $request->getParsedBody();
    $response->getBody()->write(json_encode($store->add($params['title'] ?? '', $params['body'] ?? '')));
    return $response;
});

$app->get('/notes/search', function (Request $request, Response $response) use ($store) {
    $query = $request->getQueryParams()['q'] ?? '';
    $response->getBody()->write(json_encode($store->search($query)));
    return $response;
});

$app->get('/notes/{id}/export.md', function (Request $request, Response $response, array $args) use ($store) {
    $response->getBody()->write(Export::markdown($store->find((int) $args['id'])));
    return $response->withHeader('Content-Type', 'text/markdown');
});

$app->run();
